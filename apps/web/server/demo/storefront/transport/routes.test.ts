/**
 * The store's platform routes, driven as the framework drives them: a real `Request` in, a real
 * `Response` out, over the lead service, the memory stores and the fake challenge. Covers the lead
 * form's every refusal, the privacy facts, and the demo allowance against the run-start gate that
 * counts the same admissions.
 */
import {
  DEMO_ALLOWANCE_PATH,
  DemoAllowanceSchema,
  StorePrivacyFactsSchema,
} from '@indx-workspace/contracts/demo';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as getAllowance } from '../../../../app/api/demo/allowance/route';
import { GET as getPrivacy } from '../../../../app/api/store/privacy/route';
import { POST as postLead } from '../../../../app/api/store/leads/route';
import { clearApplicationContext } from '../../../application-context';
import { installTestDomains } from '../../../application-context-fixtures';
import { fixedClock } from '../../../clock';
import { FakeChallengeVerifier } from '../../../email-link/adapters/challenge/fake';
import { createDisposableEmailList } from '../../../email-link/adapters/disposable/disposable';
import { createMemoryDirectory } from '../../../rbac/memory-directory';
import { Principal } from '../../../rbac/principal';
import { MemoryLeadStore } from '../../adapters/leads/memory';
import { MemoryDemoRunAdmissions } from '../../caps/adapters/admissions/memory';
import { MemoryDemoSpend } from '../../caps/adapters/spend/memory';
import { createDemoAllowance } from '../../caps/transport/allowance';
import { createDemoRunGate } from '../../caps/transport/gate';
import { createStoreLeadService, STORE_LEADS_PER_MINUTE_PER_CLIENT } from '../leads';
import { MAX_BODY_BYTES, type StoreRuntime } from './routes';

const T0 = '2026-11-16T09:00:00.000Z';
const HOST = 'platform.example.test';
const STORE = 'https://store.example.test';
const CHALLENGE = 'challenge-answer';
const DAY_MS = 24 * 60 * 60 * 1000;

let nextClient = 0;
const client = () => `198.51.100.${String((nextClient += 1))}`;

function lead(body: unknown, options: { ip?: string; origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip ?? client(),
  };
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin;
  if (origin !== null) headers['origin'] = origin;
  return postLead(
    new Request(`https://${HOST}/api/store/leads`, {
      method: 'POST',
      headers,
      body: options.raw ?? JSON.stringify(body),
    }),
  );
}

const enquiry = (extra: Record<string, unknown> = {}) => ({
  kind: 'enquiry',
  email: 'Visitor@Example.TEST',
  consent: true,
  challenge: CHALLENGE,
  message: 'We would like to talk.',
  ...extra,
});
const notice = (extra: Record<string, unknown> = {}) => ({
  kind: 'launch_notice',
  email: 'visitor@example.test',
  consent: true,
  challenge: CHALLENGE,
  entry: 'wiki',
  ...extra,
});

async function code(response: Response) {
  return {
    status: response.status,
    code: ((await response.json()) as { error: { code: string } }).error.code,
  };
}

interface Rig {
  readonly clock: ReturnType<typeof fixedClock>;
  readonly leads: MemoryLeadStore;
  readonly challenge: FakeChallengeVerifier;
}

function install(options: { challenge?: boolean; baseUrl?: string } = {}): Rig {
  const clock = fixedClock(T0);
  const leads = new MemoryLeadStore();
  const challenge = new FakeChallengeVerifier(CHALLENGE);
  const runtime: StoreRuntime = {
    baseUrl: options.baseUrl ?? null,
    privacy: { leadRetentionDays: null, demoWorkspaceHours: 24 },
    leads: createStoreLeadService({
      clock,
      clientIdentity: {
        trustedProxyHops: 1,
        sessionSecret: 'a-store-route-test-secret-long-enough',
      },
      challenge: options.challenge === false ? null : challenge,
      disposable: createDisposableEmailList(),
      leads,
    }),
    allowance: null,
  };
  installTestDomains({ store: runtime });
  return { clock, leads, challenge };
}

afterEach(() => {
  clearApplicationContext();
});

describe('the lead limits', () => {
  it('are pinned', () => {
    expect(STORE_LEADS_PER_MINUTE_PER_CLIENT).toBe(5);
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
  });
});

describe('POST /api/store/leads', () => {
  it('keeps an enquiry with its entry and setup under the lower-cased address, and moves the last contact', async () => {
    const { leads, clock } = install();
    await leads.recordContact({
      email: 'visitor@example.test',
      entry: 'crm-sales',
      now: new Date('2026-11-16T08:00:00.000Z'),
    });
    clock.advance(60_000);
    const response = await lead(
      enquiry({ entry: 'crm-sales', setup: { tone: 'formal', companyName: 'Acme' } }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'received' });
    expect(leads.leads).toMatchObject([
      {
        email: 'visitor@example.test',
        enquiry: 'We would like to talk.',
        enquirySetup: { entry: 'crm-sales', setup: { tone: 'formal', companyName: 'Acme' } },
        entries: ['crm-sales'],
        lastContactAt: new Date('2026-11-16T09:01:00.000Z'),
      },
    ]);
  });

  it('keeps an enquiry that names no entry and no setup with no detail', async () => {
    const { leads } = install();
    expect((await lead(enquiry())).status).toBe(202);
    expect(leads.leads[0]).toMatchObject({ enquiry: 'We would like to talk.', enquirySetup: null });
  });

  it('adds a launch notice once and moves the last contact', async () => {
    const { leads, clock } = install();
    expect((await lead(notice())).status).toBe(202);
    clock.advance(3_600_000);
    expect((await lead(notice())).status).toBe(202);
    expect((await lead(notice({ entry: 'quotation' }))).status).toBe(202);
    expect(leads.leads).toMatchObject([
      {
        launchNotices: ['wiki', 'quotation'],
        lastContactAt: new Date('2026-11-16T10:00:00.000Z'),
        createdAt: new Date(T0),
      },
    ]);
  });

  it.each([
    ['consent absent', { consent: undefined }],
    ['consent false', { consent: false }],
    ['an unknown key', { role: 'owner' }],
    ['an address that is not one', { email: 'nobody' }],
    ['an empty message', { message: '   ' }],
    ['a message past 2000 characters', { message: 'x'.repeat(2001) }],
    ['a setup with a bad control name', { setup: { 'not a name': 'x' } }],
    ['an entry that is not a slug', { entry: 'Not A Slug!' }],
  ])('refuses %s with 400 invalid_body and keeps nothing', async (_label, extra) => {
    const { leads, challenge } = install();
    expect(await code(await lead(enquiry(extra)))).toEqual({ status: 400, code: 'invalid_body' });
    expect(leads.leads).toEqual([]);
    expect(challenge.calls).toEqual([]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['empty', ''],
    ['an array', '[]'],
  ])('refuses a body that is %s with 400 invalid_body', async (_label, raw) => {
    install();
    expect(await code(await lead(null, { raw }))).toEqual({ status: 400, code: 'invalid_body' });
  });

  it('refuses a launch notice without consent or without an entry', async () => {
    const { leads } = install();
    expect((await lead(notice({ consent: false }))).status).toBe(400);
    expect((await lead(notice({ entry: undefined }))).status).toBe(400);
    expect(leads.leads).toEqual([]);
  });

  it('refuses a failed challenge with 403 and keeps nothing', async () => {
    const { leads } = install();
    expect(await code(await lead(enquiry({ challenge: 'wrong' })))).toEqual({
      status: 403,
      code: 'store_lead_challenge_failed',
    });
    expect(leads.leads).toEqual([]);
  });

  it('answers 503 store_lead_unavailable where no challenge is configured, checking and keeping nothing', async () => {
    const { leads } = install({ challenge: false });
    expect(await code(await lead(enquiry()))).toEqual({
      status: 503,
      code: 'store_lead_unavailable',
    });
    expect(leads.leads).toEqual([]);
  });

  it('answers 503 store_lead_unavailable when no store runtime is installed at all', async () => {
    installTestDomains({});
    clearApplicationContext();
    expect(await code(await lead(enquiry()))).toEqual({
      status: 503,
      code: 'store_lead_unavailable',
    });
  });

  it('answers 400 invalid_body for a missing consent whether or not a challenge is configured', async () => {
    install({ challenge: false });
    expect(await code(await lead(enquiry({ consent: false })))).toEqual({
      status: 400,
      code: 'invalid_body',
    });
    clearApplicationContext();
    expect((await lead(enquiry({ consent: false }))).status).toBe(400);
  });

  it('limits one client address with 429 and Retry-After, before it spends a challenge check', async () => {
    const { leads, challenge } = install();
    const ip = client();
    for (let sent = 0; sent < STORE_LEADS_PER_MINUTE_PER_CLIENT; sent += 1) {
      expect((await lead(enquiry({ email: `v${String(sent)}@example.test` }), { ip })).status).toBe(
        202,
      );
    }
    const checked = challenge.calls.length;
    const refused = await lead(enquiry({ email: 'late@example.test' }), { ip });
    expect(await code(refused.clone())).toEqual({ status: 429, code: 'store_lead_rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(challenge.calls).toHaveLength(checked);
    expect(leads.leads).toHaveLength(STORE_LEADS_PER_MINUTE_PER_CLIENT);
    // Another client address is not limited by it.
    expect((await lead(enquiry({ email: 'other@example.test' }))).status).toBe(202);
  });

  it('answers a disposable address 202 received, and keeps nothing', async () => {
    const { leads, challenge } = install();
    const kept = await lead(enquiry({ email: 'real@example.test' }));
    const blocked = await lead(enquiry({ email: 'throwaway@mailinator.com' }));
    expect(blocked.status).toBe(kept.status);
    expect(await blocked.json()).toEqual(await kept.json());
    expect(leads.leads.map((row) => row.email)).toEqual(['real@example.test']);
    expect(challenge.calls).toHaveLength(2);
    const blockedNotice = await lead(notice({ email: 'x@10minutemail.com' }));
    expect(blockedNotice.status).toBe(202);
    expect(leads.leads).toHaveLength(1);
  });

  it('accepts a request from the store origin and refuses any other origin or none', async () => {
    const { leads } = install({ baseUrl: `${STORE}/signin` });
    expect((await lead(enquiry(), { origin: STORE })).status).toBe(202);
    for (const origin of ['https://evil.example.test', 'http://store.example.test', null]) {
      expect(await code(await lead(enquiry({ email: 'b@example.test' }), { origin }))).toEqual({
        status: 403,
        code: 'cross_origin',
      });
    }
    expect(leads.leads).toHaveLength(1);
  });

  it('refuses the store origin while the base URL is unset', async () => {
    install();
    expect((await lead(enquiry(), { origin: STORE })).status).toBe(403);
  });
});

describe('GET /api/store/privacy', () => {
  const read = async (privacy: StoreRuntime['privacy']) => {
    installTestDomains({ store: { baseUrl: null, privacy, leads: null, allowance: null } });
    const response = await getPrivacy();
    return { response, body: StorePrivacyFactsSchema.parse(await response.json()) };
  };

  it('answers null while the retention period is not set', async () => {
    const { response, body } = await read({ leadRetentionDays: null, demoWorkspaceHours: 24 });
    expect(response.status).toBe(200);
    expect(body).toEqual({ leadRetentionDays: null, demoWorkspaceHours: 24 });
  });

  it('answers the configured period', async () => {
    const { body } = await read({ leadRetentionDays: 90, demoWorkspaceHours: 24 });
    expect(body).toEqual({ leadRetentionDays: 90, demoWorkspaceHours: 24 });
  });

  it('answers 503 service_unavailable in the standard envelope where no store runtime is installed', async () => {
    clearApplicationContext();
    expect(await code(await getPrivacy())).toEqual({ status: 503, code: 'service_unavailable' });
  });

  it('needs no session and is never cached', async () => {
    const { response } = await read({ leadRetentionDays: 30, demoWorkspaceHours: 24 });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/demo/allowance', () => {
  const SECRET = 'an-allowance-test-session-secret-long-enough';
  const DEMO_WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const REAL_WORKSPACE = '33333333-3333-4333-8333-333333333333';
  const PERSON = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const PER_DAY = 20;

  async function principalIn(
    workspaceId: string,
    userId: string,
    role: 'guest' | 'owner' = 'guest',
  ): Promise<Principal> {
    const { mintSessionToken, newEmailLinkSessionClaims, verifySessionToken } =
      await import('../../../auth/session');
    const token = await mintSessionToken(
      newEmailLinkSessionClaims('guest@example.test', 'slug'),
      SECRET,
    );
    const verified = await verifySessionToken(token, SECRET);
    if (!verified.ok) throw new Error('fixture token did not verify');
    const built = Principal.fromSession(verified.claims, { id: workspaceId, slug: 'slug' }, role, {
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      userId,
      label: 'Guest',
    });
    if (!built.ok) throw new Error(built.because);
    return built.principal;
  }

  function wire(principal: Principal | null) {
    const clock = fixedClock(T0);
    const admissions = new MemoryDemoRunAdmissions();
    const demoExpiresAt = (workspaceId: string) =>
      Promise.resolve(
        workspaceId === REAL_WORKSPACE ? null : new Date(clock.now().getTime() + 7_200_000),
      );
    const gate = createDemoRunGate({
      settings: {
        runsPerPersonPerDay: PER_DAY,
        runsPerClientPerDay: 60,
        maxTurnsPerRun: 8,
        maxCostPerRunUsd: 0.5,
        siteMaxCostPerDayUsd: 30,
      },
      admissions,
      spend: new MemoryDemoSpend(),
      clock,
      demoExpiresAt,
      clientOf: (_headers, limit) => ({ key: 'shared', limit }),
    });
    const start = (userId: string) =>
      gate.refusal({
        workspaceId: DEMO_WORKSPACE,
        userId,
        clientHeaders: new Headers(),
        newRun: true,
      });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory(),
        identify: () => Promise.resolve(principal),
      },
      store: {
        baseUrl: null,
        privacy: { leadRetentionDays: null, demoWorkspaceHours: 24 },
        leads: null,
        allowance: createDemoAllowance({
          runsPerPersonPerDay: PER_DAY,
          admissions,
          demoExpiresAt,
          clock,
        }),
      },
    });
    return { clock, start };
  }

  const call = () => getAllowance(new Request(`https://${HOST}${DEMO_ALLOWANCE_PATH}`));

  it('answers runs per day, runs left and when the workspace ends', async () => {
    wire(await principalIn(DEMO_WORKSPACE, PERSON));
    const response = await call();
    expect(response.status).toBe(200);
    expect(DemoAllowanceSchema.parse(await response.json())).toEqual({
      runsPerDay: PER_DAY,
      runsLeft: PER_DAY,
      expiresAt: '2026-11-16T11:00:00.000Z',
    });
  });

  it('counts the same admissions the run-start gate records, one run at a time', async () => {
    const { start } = wire(await principalIn(DEMO_WORKSPACE, PERSON));
    for (let used = 1; used <= 3; used += 1) {
      expect(await start(PERSON)).toBeNull();
      expect(DemoAllowanceSchema.parse(await (await call()).json()).runsLeft).toBe(PER_DAY - used);
    }
    // Another person's runs are not this person's.
    expect(await start(OTHER)).toBeNull();
    expect(DemoAllowanceSchema.parse(await (await call()).json()).runsLeft).toBe(PER_DAY - 3);
  });

  it('answers 0 left once the cap is reached, and the gate refuses the next start', async () => {
    const { start } = wire(await principalIn(DEMO_WORKSPACE, PERSON));
    for (let used = 0; used < PER_DAY; used += 1) await start(PERSON);
    expect(DemoAllowanceSchema.parse(await (await call()).json()).runsLeft).toBe(0);
    expect(await start(PERSON)).toEqual({ code: 'demo_person_runs_reached' });
    expect(DemoAllowanceSchema.parse(await (await call()).json()).runsLeft).toBe(0);
  });

  it('returns runs to the person as the window passes', async () => {
    const { start, clock } = wire(await principalIn(DEMO_WORKSPACE, PERSON));
    await start(PERSON);
    await start(PERSON);
    clock.advance(DAY_MS + 1);
    expect(DemoAllowanceSchema.parse(await (await call()).json()).runsLeft).toBe(PER_DAY);
  });

  it('answers 404 demo_workspace_not_found for a workspace that is not a demo workspace', async () => {
    wire(await principalIn(REAL_WORKSPACE, PERSON));
    expect(await code(await call())).toEqual({ status: 404, code: 'demo_workspace_not_found' });
  });

  it('answers 404, not 403, to the owner of a real workspace: every role may ask', async () => {
    wire(await principalIn(REAL_WORKSPACE, PERSON, 'owner'));
    expect(await code(await call())).toEqual({ status: 404, code: 'demo_workspace_not_found' });
  });

  it('answers 401 unauthenticated with no session', async () => {
    wire(null);
    expect(await code(await call())).toEqual({ status: 401, code: 'unauthenticated' });
  });

  it('answers 404 where the deployment has no database to count in', async () => {
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory(),
        identify: () => principalIn(DEMO_WORKSPACE, PERSON),
      },
      store: {
        baseUrl: null,
        privacy: { leadRetentionDays: null, demoWorkspaceHours: 24 },
        leads: null,
        allowance: null,
      },
    });
    expect((await call()).status).toBe(404);
  });
});
