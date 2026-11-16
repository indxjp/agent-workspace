/**
 * SDK conformance, shares: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type PublishShareCommand,
  SHARE_EXPIRIES,
  SHARE_MODES,
  SHARE_PASSPHRASE_MAX_LENGTH,
  SHARE_SUBJECT_TYPES,
  SHARE_VISIBILITIES,
  ShareListItemSchema,
  ShareListResponseSchema,
  ShareResourceSchema,
} from '@indx-workspace/contracts/shares';
import { SharingPolicySchema } from '@indx-workspace/contracts/workspaces';
import { type ShareRecord } from '@agent-workspace/core/db';
import { toShareListItem, toShareResource } from './shares/core/resource';
import {
  GET as readSharingPolicy,
  PATCH as patchSharingPolicy,
} from '../app/api/sharing-policies/route';
import { createMemoryDirectory } from './rbac/memory-directory';
import { Principal } from './rbac/principal';
import { PublishShareRequestSchema } from './shares/core/input';
import { parsePublishShareRequest } from './shares/publish-request';
import { type WorkspaceSharing } from './shares/runtime';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';

const SHARES_WORKSPACE = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

const SHARES_PRINCIPAL = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

const SHARES_ROLE_HEADER = 'x-conformance-role';

const TOKEN = 'pub_conformance-token-never-on-a-private-wire';

const record: ShareRecord = {
  id: '99999999-9999-4999-8999-999999999999',
  workspaceId: SHARES_WORKSPACE,
  tokenHash: 'not-checked-here',
  subjectType: 'session',
  subjectId: '55555555-5555-4555-8555-555555555555',
  subjectLabel: 'Incident review',
  visibility: 'workspace',
  mode: null,
  snapshot: { messages: [] },
  include: { technicalDetails: true },
  budgetCapUsd: null,
  spentUsd: '0',
  stopped: false,
  expiresAt: null,
  passphraseHash: 'sensitive-hash',
  createdBy: null,
  publisherPrincipalId: SHARES_PRINCIPAL,
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date('2026-09-21T10:00:00.000Z'),
};

const runnable: ShareRecord = {
  ...record,
  subjectType: 'agent',
  subjectId: '11111111-1111-4111-8111-111111111111',
  visibility: 'public',
  mode: 'runnable',
  include: {},
  budgetCapUsd: '20.0000',
  spentUsd: '1.250000',
  stopped: true,
  expiresAt: new Date('2026-09-28T10:00:00.000Z'),
  suspendedAt: new Date('2026-09-22T10:00:00.000Z'),
};

let publicSharing = false;

const unused = (): Promise<never> =>
  Promise.reject(new Error('not used by the sharing-policy routes'));

const sharing: WorkspaceSharing = {
  shares: {
    list: unused,
    get: unused,
    findByTokenHash: unused,
    create: unused,
    getPublicSharingEnabled: () => Promise.resolve(publicSharing),
    setPublicSharingEnabled: (enabled) => {
      publicSharing = enabled;
      return Promise.resolve();
    },
    revoke: unused,
    stop: unused,
    reserveVisitorMessage: unused,
  },
  views: { record: unused, count: unused },
  audit: { write: () => Promise.resolve() },
};

const roleOf = (request: Request): 'owner' | 'admin' =>
  request.headers.get(SHARES_ROLE_HEADER) === 'admin' ? 'admin' : 'owner';

const policyRequest = (method: 'GET' | 'PATCH', role: 'owner' | 'admin', body?: string) =>
  new Request('https://example.invalid/api/sharing-policies', {
    method,
    headers: {
      [SHARES_ROLE_HEADER]: role,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });

describe('shares', () => {
  it('renders the 201 (bare) and every list item (with its view count) into the published shape', () => {
    const published = ShareResourceSchema.safeParse(toShareResource(record, TOKEN));
    expect(published.success, JSON.stringify(published)).toBe(true);
    const publicPublished = ShareResourceSchema.safeParse(toShareResource(runnable, TOKEN));
    expect(publicPublished.success, JSON.stringify(publicPublished)).toBe(true);
    if (!publicPublished.success) return;
    expect(publicPublished.data.url).toBe(`/p/${TOKEN}`);
    const publicItem = ShareListItemSchema.safeParse(toShareListItem(runnable, 3));
    expect(publicItem.success, JSON.stringify(publicItem)).toBe(true);
    if (!publicItem.success) return;
    expect(publicItem.data).not.toHaveProperty('url');
    expect(publicItem.data.viewCount).toBe(3);

    const list = ShareListResponseSchema.safeParse({
      shares: [toShareListItem(record, 0), toShareListItem(runnable, 3)],
    });
    expect(list.success, JSON.stringify(list)).toBe(true);
    // The wire never carries the token of a non-public share, nor any hash: `.strict()` and the
    // public-link invariant are what refuse a serializer that started spreading the record.
    expect(JSON.stringify(toShareResource(record, TOKEN))).not.toContain(TOKEN);
    expect(JSON.stringify(toShareListItem(runnable, 3))).not.toContain('sensitive-hash');
    expect(JSON.stringify(toShareListItem(runnable, 3))).not.toContain('not-checked-here');
  });

  it('restates the same subject types, visibilities, modes, expiries and passphrase bound as the contract', () => {
    const request = PublishShareRequestSchema.shape;
    expect(request.subjectType.options).toEqual([...SHARE_SUBJECT_TYPES]);
    expect(request.visibility.options).toEqual([...SHARE_VISIBILITIES]);
    expect(request.mode.unwrap().options).toEqual([...SHARE_MODES]);
    expect(request.expiry.unwrap().options).toEqual([...SHARE_EXPIRIES]);
    const command = {
      subjectType: 'session',
      subjectId: 'session-1',
      subjectLabel: 'Session',
      visibility: 'private',
    } as const;
    expect(() =>
      parsePublishShareRequest({ ...command, passphrase: 'p'.repeat(SHARE_PASSPHRASE_MAX_LENGTH) }),
    ).not.toThrow();
    expect(() =>
      parsePublishShareRequest({
        ...command,
        passphrase: 'p'.repeat(SHARE_PASSPHRASE_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });
});

/** Every publish command the SDK sends: one or more per subject type, each at its limits. */
const ACCEPTED_PUBLISH_COMMANDS: readonly PublishShareCommand[] = [
  { subjectType: 'session', subjectId: 's', subjectLabel: 'S', visibility: 'workspace' },
  {
    subjectType: 'session',
    subjectId: 's',
    subjectLabel: 'S',
    visibility: 'public',
    include: { technicalDetails: true, outputFiles: false },
    expiry: '7 days',
    passphrase: 'open sesame',
  },
  {
    subjectType: 'agent',
    subjectId: 'a',
    subjectLabel: 'A',
    visibility: 'workspace',
    mode: 'definition',
  },
  {
    subjectType: 'agent',
    subjectId: 'a',
    subjectLabel: 'A',
    visibility: 'public',
    mode: 'runnable',
    budgetCapUsd: 5,
  },
  {
    subjectType: 'project',
    subjectId: 'p',
    subjectLabel: 'P',
    visibility: 'private',
    expiry: 'never',
  },
  { subjectType: 'skill', subjectId: 'k', subjectLabel: 'K', visibility: 'workspace' },
];

/** The pairings the contract documents as invalid, plus an unknown key and a missing label. */
const REFUSED_PUBLISH_BODIES: readonly unknown[] = [
  {
    subjectType: 'session',
    subjectId: 's',
    subjectLabel: 'S',
    visibility: 'workspace',
    mode: 'definition',
  },
  {
    subjectType: 'agent',
    subjectId: 'a',
    subjectLabel: 'A',
    visibility: 'workspace',
    include: {},
  },
  {
    subjectType: 'agent',
    subjectId: 'a',
    subjectLabel: 'A',
    visibility: 'workspace',
    budgetCapUsd: 5,
  },
  {
    subjectType: 'project',
    subjectId: 'p',
    subjectLabel: 'P',
    visibility: 'public',
    budgetCapUsd: 5,
  },
  {
    subjectType: 'session',
    subjectId: 's',
    subjectLabel: 'S',
    visibility: 'workspace',
    extra: 1,
  },
  // Until RF-103 the route requires the label the SDK's command carries.
  { subjectType: 'session', subjectId: 's', visibility: 'workspace' },
];

describe('shares', () => {
  it('accepts every publish command the SDK sends, and refuses the pairings the contract documents', () => {
    for (const command of ACCEPTED_PUBLISH_COMMANDS) {
      expect(() => parsePublishShareRequest(command), JSON.stringify(command)).not.toThrow();
      expect(parsePublishShareRequest(command)).toEqual(command);
    }
    for (const body of REFUSED_PUBLISH_BODIES) {
      expect(() => parsePublishShareRequest(body), JSON.stringify(body)).toThrow();
    }
  });
});

/** Installs the shares domain over the in-memory `sharing` and an RBAC that reads the role per request. */
function installSharingPolicyDomains(): void {
  installTestDomains({
    shares: {
      resolveActor: (request) =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: SHARES_WORKSPACE,
          principalId: SHARES_PRINCIPAL,
          ownerPrincipalId: SHARES_PRINCIPAL,
          userId: null,
          userLabel: 'Conformance key',
          role: roleOf(request),
        }),
      forWorkspace: () => Promise.resolve(sharing),
      resolvePublic: unused,
      sharingMaterials: unused,
      sessionRuns: unused,
      subjectOwnership: unused,
      runPublic: unused,
    },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: (request) =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: SHARES_PRINCIPAL,
            apiKeyId: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
            workspaceId: SHARES_WORKSPACE,
            role: roleOf(request),
            label: 'Conformance key',
          }),
        ),
    },
  });
}

describe('shares', () => {
  describe('sharing policy', () => {
    afterEach(() => {
      clearApplicationContext();
    });

    it('answers both routes through the real handlers with the published envelope', async () => {
      installSharingPolicyDomains();

      const read = await readSharingPolicy(policyRequest('GET', 'admin'));
      expect(read.status).toBe(200);
      expect(SharingPolicySchema.parse(await read.json())).toEqual({ publicSharing: false });

      const enabled = await patchSharingPolicy(
        policyRequest('PATCH', 'owner', JSON.stringify({ publicSharing: true })),
      );
      expect(enabled.status).toBe(200);
      expect(SharingPolicySchema.parse(await enabled.json())).toEqual({ publicSharing: true });
      expect(publicSharing).toBe(true);

      const reread = await readSharingPolicy(policyRequest('GET', 'owner'));
      expect(SharingPolicySchema.parse(await reread.json())).toEqual({ publicSharing: true });

      const asAdmin = await patchSharingPolicy(
        policyRequest('PATCH', 'admin', JSON.stringify({ publicSharing: false })),
      );
      expect(asAdmin.status).toBe(403);
      expect(publicSharing).toBe(true);

      const notBoolean = await patchSharingPolicy(
        policyRequest('PATCH', 'owner', JSON.stringify({ publicSharing: 'yes' })),
      );
      expect(notBoolean.status).toBe(400);
      const refusal: unknown = await notBoolean.json();
      expect(refusal).toMatchObject({ error: { code: 'invalid_policy' } });
    });
  });
});
