/**
 * Differential conformance for the `concept-publication` family, application side: the Lean
 * publication concept (formal/AgentWorkspace/Concepts/Share.lean) replayed against the REAL web
 * server code.
 *
 *   - `options.json`, `fields.json`, `vocabularies.json`: `PublishShareRequestSchema` accepts
 *     exactly the commands whose options fit their subject type, and exactly the field values and
 *     vocabulary members the model accepts.
 *   - `shares.json`: `toShareResource` renders exactly the model's keys (with and without a view
 *     count) and the model's `url`; `ShareService.resolve` opens a public link at the vector's
 *     instant exactly when the model's `publiclyOpen` says so, and refuses it with
 *     `share_unavailable` otherwise.
 *   - `publish.json`: `ShareService.publish` (with the release gate passed explicitly) refuses
 *     exactly the model's requests with the model's `invalid_share` message, and otherwise writes
 *     the model's mode, budget, expiry and passphrase hash with a `pub_` token.
 *   - `resolve.json`: `ShareService.resolve` with a missing, wrong or right passphrase answers the
 *     model's `resolveAt` (the passphrase hash is one the real `publish` produced).
 *   - `listing.json`: the real `GET /api/shares` handler, behind the real RBAC decision, lists a
 *     share exactly when the model's `listedFor` says so.
 *   - `visitor-limit.json`: `RunnableShareService.message` reserves with the model's limit and
 *     window.
 *
 * The package side (tables, checks, the contracts' Zod resource schema) is
 * `tests/formal/concept-publication.test.ts`.
 */
import type { CreateShareInput, ShareRecord } from '@agent-workspace/core/db';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET as listShares } from '../app/api/shares/route';
import { DomainError } from '../server/errors';
import { createMemoryDirectory } from '../server/rbac/memory-directory';
import { Principal } from '../server/rbac/principal';
import { ROLES, type Role } from '../server/rbac/roles';
import { PublishShareRequestSchema, type PublishShareInput } from '../server/shares/core/input';
import { toShareResource } from '../server/shares/core/resource';
import { type WorkspaceSharing } from '../server/shares/core/runtime';
import { ShareService } from '../server/shares/core/service';
import { RunnableShareService } from '../server/shares/runnable/service';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import { clearApplicationContext } from '../server/application-context';
import { installTestDomains } from '../server/application-context-fixtures';

const optionVectors = loadVectors('concept-publication', 'options.json');
const fieldVectors = loadVectors('concept-publication', 'fields.json');
const vocabularyVectors = loadVectors('concept-publication', 'vocabularies.json');
const shareVectors = loadVectors('concept-publication', 'shares.json');
const publishVectors = loadVectors('concept-publication', 'publish.json');
const resolveVectors = loadVectors('concept-publication', 'resolve.json');
const listingVectors = loadVectors('concept-publication', 'listing.json');
const visitorLimitVectors = loadVectors('concept-publication', 'visitor-limit.json');

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

function asStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((item, index) => asString(item, `${what}[${String(index)}]`));
}

function asNullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function asInstant(value: unknown, what: string): Date | null {
  return value === null ? null : new Date(asNumber(value, what));
}

/** A publish body that fits every subject type; each vector changes one part of it. */
const BASE_BODY = {
  subjectId: 'subject-1',
  subjectLabel: 'Label',
  visibility: 'private',
} as const;

describe('publish options fit their subject type', () => {
  it.each(optionVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const mode = asNullableString(input['mode'], `${vector.id} mode`);
    const body = {
      ...BASE_BODY,
      subjectType: asString(input['subjectType'], `${vector.id} subjectType`),
      ...(mode === null ? {} : { mode }),
      ...(asBoolean(input['include'], vector.id) ? { include: { technicalDetails: true } } : {}),
      ...(asBoolean(input['budget'], vector.id) ? { budgetCapUsd: 5 } : {}),
      ...(asBoolean(input['transcript'], vector.id)
        ? { transcript: { runIds: ['00000000-0000-4000-8000-0000000000cc'] } }
        : {}),
      ...(asBoolean(input['definition'], vector.id)
        ? { definition: { name: 'Agent', instructions: '' } }
        : {}),
    };
    expect(PublishShareRequestSchema.safeParse(body).success).toBe(expected['fits']);
  });
});

describe('publish field bounds', () => {
  it.each(fieldVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const field = asString(input['field'], `${vector.id} field`);
    const value = asString(input['value'], `${vector.id} value`);
    const base = { ...BASE_BODY, subjectType: 'agent' };
    const body =
      field === 'subjectId'
        ? { ...base, subjectId: value }
        : field === 'passphraseLength'
          ? { ...base, passphrase: 'x'.repeat(Number(value)) }
          : field === 'budgetCapUsd'
            ? { ...base, mode: 'runnable', budgetCapUsd: Number(value) }
            : null;
    if (body === null) throw new Error(`${vector.id}: unknown field ${field}`);
    expect(PublishShareRequestSchema.safeParse(body).success).toBe(expected['accepted']);
  });
});

describe('publish vocabularies', () => {
  it.each(vocabularyVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const vocabulary = asString(input['vocabulary'], `${vector.id} vocabulary`);
    const value = asString(input['value'], `${vector.id} value`);
    const base = { ...BASE_BODY, subjectType: 'agent' };
    const body =
      vocabulary === 'subject-type'
        ? { ...BASE_BODY, subjectType: value }
        : vocabulary === 'visibility'
          ? { ...base, visibility: value }
          : vocabulary === 'mode'
            ? { ...base, mode: value }
            : vocabulary === 'expiry'
              ? { ...base, expiry: value }
              : null;
    if (body === null) throw new Error(`${vector.id}: unknown vocabulary ${vocabulary}`);
    expect(PublishShareRequestSchema.safeParse(body).success).toBe(expected['valid']);
  });
});

function shareRecord(value: unknown, what: string): ShareRecord {
  const s = asRecord(value, what);
  const include = asRecord(s['include'], `${what} include`);
  const subjectType = asString(s['subjectType'], `${what} subjectType`);
  const visibility = asString(s['visibility'], `${what} visibility`);
  const mode = asNullableString(s['mode'], `${what} mode`);
  if (
    subjectType !== 'agent' &&
    subjectType !== 'session' &&
    subjectType !== 'project' &&
    subjectType !== 'skill'
  ) {
    throw new Error(`${what}: subject type ${subjectType}`);
  }
  if (visibility !== 'private' && visibility !== 'workspace' && visibility !== 'public') {
    throw new Error(`${what}: visibility ${visibility}`);
  }
  if (mode !== null && mode !== 'definition' && mode !== 'runnable') {
    throw new Error(`${what}: mode ${mode}`);
  }
  const createdAt = asInstant(s['createdAt'], `${what} createdAt`);
  if (createdAt === null) throw new Error(`${what}: createdAt is required`);
  return {
    id: asString(s['id'], `${what} id`),
    workspaceId: asString(s['workspaceId'], `${what} workspaceId`),
    token: asString(s['token'], `${what} token`),
    subjectType,
    subjectId: asString(s['subjectId'], `${what} subjectId`),
    subjectLabel: asString(s['subjectLabel'], `${what} subjectLabel`),
    visibility,
    mode,
    snapshot: s['snapshot'],
    include: Object.fromEntries(
      Object.entries(include).map(([key, flag]) => [key, asBoolean(flag, `${what} ${key}`)]),
    ),
    budgetCapUsd: asNullableString(s['budgetCapUsd'], `${what} budgetCapUsd`),
    spentUsd: asString(s['spentUsd'], `${what} spentUsd`),
    stopped: asBoolean(s['stopped'], `${what} stopped`),
    expiresAt: asInstant(s['expiresAt'], `${what} expiresAt`),
    passphraseHash: asNullableString(s['passphraseHash'], `${what} passphraseHash`),
    createdBy: asNullableString(s['createdBy'], `${what} createdBy`),
    publisherPrincipalId: asString(s['publisherPrincipalId'], `${what} publisherPrincipalId`),
    revokedAt: asInstant(s['revokedAt'], `${what} revokedAt`),
    suspendedAt: asInstant(s['suspendedAt'], `${what} suspendedAt`),
    createdAt,
  };
}

interface FakeSharingOptions {
  readonly found?: ShareRecord;
  readonly listed?: readonly ShareRecord[];
  readonly publicSharingEnabled?: boolean;
}

/** A workspace's sharing ports as plain doubles; `create` echoes the values it was given. */
function fakeSharing(options: FakeSharingOptions = {}) {
  const recordView = vi.fn(() => Promise.resolve());
  const create = vi.fn((values: CreateShareInput) => Promise.resolve(recordFromCreate(values)));
  const reserveVisitorMessage = vi.fn(() => Promise.resolve({ kind: 'unavailable' as const }));
  const sharing: WorkspaceSharing = {
    shares: {
      list: vi.fn(() => Promise.resolve([...(options.listed ?? [])])),
      get: vi.fn(),
      findByToken: vi.fn(() => Promise.resolve(options.found ?? null)),
      create,
      getPublicSharingEnabled: vi.fn(() => Promise.resolve(options.publicSharingEnabled ?? true)),
      setPublicSharingEnabled: vi.fn(),
      revoke: vi.fn(),
      stop: vi.fn(),
      reserveVisitorMessage,
    },
    views: {
      record: recordView,
      count: vi.fn(() => Promise.resolve(0)),
    },
    audit: { write: vi.fn(() => Promise.resolve()) },
  };
  return { sharing, recordView, create, reserveVisitorMessage };
}

function recordFromCreate(values: CreateShareInput): ShareRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    token: values.token,
    subjectType: values.subjectType,
    subjectId: values.subjectId,
    subjectLabel: values.subjectLabel,
    visibility: values.visibility,
    mode: values.mode ?? null,
    snapshot: values.snapshot ?? null,
    include: values.include ?? {},
    budgetCapUsd: values.budgetCapUsd ?? null,
    spentUsd: '0',
    stopped: false,
    expiresAt: values.expiresAt ?? null,
    passphraseHash: values.passphraseHash ?? null,
    createdBy: values.createdBy ?? null,
    publisherPrincipalId: values.publisherPrincipalId,
    revokedAt: null,
    suspendedAt: null,
    createdAt: new Date(0),
  };
}

function asRole(value: unknown, what: string): Role {
  const found = ROLES.find((role) => role === value);
  if (found === undefined) throw new Error(`${what}: expected a role`);
  return found;
}

const ACTOR = {
  principalId: '00000000-0000-4000-8000-000000000004',
  ownerPrincipalId: '00000000-0000-4000-8000-000000000004',
  userId: '00000000-0000-4000-8000-000000000003',
  userLabel: 'Publisher',
} as const;

function publishInput(value: unknown, what: string): PublishShareInput {
  const r = asRecord(value, what);
  const subjectType = asString(r['subjectType'], `${what} subjectType`);
  const visibility = asString(r['visibility'], `${what} visibility`);
  const mode = asNullableString(r['mode'], `${what} mode`);
  const budget = asNullableString(r['budgetCapUsd'], `${what} budgetCapUsd`);
  const expiry = asNullableString(r['expiry'], `${what} expiry`);
  const passphrase = asNullableString(r['passphrase'], `${what} passphrase`);
  const parsed = PublishShareRequestSchema.parse({
    subjectType,
    subjectId: 'subject-1',
    subjectLabel: 'Label',
    visibility,
    ...(mode === null ? {} : { mode }),
    ...(budget === null ? {} : { budgetCapUsd: Number(budget) }),
    ...(expiry === null ? {} : { expiry }),
    ...(passphrase === null ? {} : { passphrase }),
  });
  const { transcript, definition, ...input } = parsed;
  if (transcript !== undefined || definition !== undefined) throw new Error(`${what}: content`);
  return input;
}

const PASSPHRASE = 'open sesame';

/** The hash the real `publish` stores for {@link PASSPHRASE}. */
async function realPassphraseHash(): Promise<string> {
  const { sharing, create } = fakeSharing();
  await new ShareService(sharing, false).publish(
    publishInput(
      {
        subjectType: 'session',
        visibility: 'private',
        mode: null,
        budgetCapUsd: null,
        expiry: null,
        passphrase: PASSPHRASE,
      },
      'passphrase',
    ),
    { ...ACTOR, role: 'owner' },
  );
  const hash = create.mock.calls[0]?.[0].passphraseHash;
  if (typeof hash !== 'string') throw new Error('publish stored no passphrase hash');
  return hash;
}

describe('typed shares against the wire rendering and public resolution', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(shareVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const record = shareRecord(input['share'], `${vector.id} share`);

    const resource = toShareResource(record);
    expect(Object.keys(resource)).toEqual(asStrings(expected['keys'], `${vector.id} keys`));
    expect(Object.keys(toShareResource(record, 3))).toEqual(
      asStrings(expected['listKeys'], `${vector.id} listKeys`),
    );
    expect('url' in resource ? resource.url : null).toBe(expected['url']);

    vi.useFakeTimers({ now: asNumber(input['now'], `${vector.id} now`) });
    const { sharing, recordView } = fakeSharing({ found: record });
    const outcome = await new ShareService(sharing, false).resolve(record.token).then(
      () => 'opened',
      (error: unknown) =>
        error instanceof DomainError ? error.code : `unexpected: ${String(error)}`,
    );
    const opens = asBoolean(expected['publiclyOpen'], `${vector.id} publiclyOpen`);
    expect(outcome).toBe(opens ? 'opened' : 'share_unavailable');
    expect(recordView).toHaveBeenCalledTimes(opens ? 1 : 0);
  });
});

describe('ShareService.publish against the model', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(publishVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const now = asNumber(input['now'], `${vector.id} now`);
    vi.useFakeTimers({ now });
    const { sharing, create } = fakeSharing({
      publicSharingEnabled: asBoolean(input['publicSharingEnabled'], vector.id),
    });
    const service = new ShareService(sharing, asBoolean(input['runnableEnabled'], vector.id));
    const request = publishInput(input['request'], `${vector.id} request`);
    const role = asRole(input['role'], `${vector.id} role`);
    const outcome = await service.publish(request, { ...ACTOR, role }).then(
      () => null,
      (error: unknown) => error,
    );
    if (expected['outcome'] === 'refused') {
      expect(outcome).toBeInstanceOf(DomainError);
      if (!(outcome instanceof DomainError)) return;
      expect(outcome.code).toBe(expected['code']);
      expect(outcome.publicMessage).toBe(expected['message']);
      expect(create).not.toHaveBeenCalled();
      return;
    }
    expect(outcome).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    const values = create.mock.calls[0]?.[0];
    if (values === undefined) throw new Error(`${vector.id}: create was not called`);
    expect(values.mode ?? null).toBe(expected['mode']);
    expect(values.budgetCapUsd ?? null).toBe(expected['budgetCapUsd']);
    expect(values.expiresAt?.getTime() ?? null).toBe(expected['expiresAt']);
    expect(values.passphraseHash !== null && values.passphraseHash !== undefined).toBe(
      expected['hasPassphraseHash'],
    );
    expect(values.token.startsWith(asString(expected['tokenPrefix'], vector.id))).toBe(true);
    expect(values.publisherPrincipalId).toBe(ACTOR.principalId);
  });
});

describe('ShareService.resolve with a passphrase against the model', () => {
  let hash = '';
  beforeAll(async () => {
    hash = await realPassphraseHash();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(resolveVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const modelled = shareRecord(input['share'], `${vector.id} share`);
    const record = { ...modelled, passphraseHash: modelled.passphraseHash === null ? null : hash };
    const attempt = asString(input['attempt'], `${vector.id} attempt`);
    const presented =
      attempt === 'right' ? PASSPHRASE : attempt === 'wrong' ? 'not the passphrase' : undefined;
    vi.useFakeTimers({ now: asNumber(input['now'], `${vector.id} now`) });
    const { sharing, recordView } = fakeSharing({ found: record });
    const code = await new ShareService(sharing, false).resolve(record.token, presented).then(
      () => null,
      (error: unknown) =>
        error instanceof DomainError ? error.code : `unexpected: ${String(error)}`,
    );
    expect(code).toBe(expected['code']);
    expect(recordView).toHaveBeenCalledTimes(expected['opened'] === true ? 1 : 0);
  });
});

describe('GET /api/shares lists against the model', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it.each(listingVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const record = shareRecord(input['share'], `${vector.id} share`);
    const role = asRole(input['role'], `${vector.id} role`);
    const viewer = asString(input['viewer'], `${vector.id} viewer`);
    const workspaceId = record.workspaceId;
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory(),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: viewer,
              apiKeyId: '00000000-0000-4000-8000-0000000000bb',
              workspaceId,
              role,
              label: 'Listing vector key',
            }),
          ),
      },
    });
    const { sharing } = fakeSharing({ listed: [record] });
    installTestDomains({
      shares: {
        resolveActor: () =>
          Promise.resolve({
            kind: 'workspace',
            workspaceId,
            principalId: viewer,
            ownerPrincipalId: viewer,
            userId: null,
            userLabel: 'Listing vector key',
            role,
          }),
        forWorkspace: () => Promise.resolve(sharing),
        resolvePublic: () => Promise.resolve(null),
        sharingMaterials: () => Promise.resolve({ values: [], referenceIds: [] }),
        sessionRuns: () => Promise.reject(new Error('not used')),
        subjectOwnership: () => Promise.resolve('unknown'),
        runPublic: () => Promise.reject(new Error('not used')),
      },
    });
    const response = await listShares(new Request('https://control-plane.test/api/shares'));
    expect(response.status).toBe(200);
    const body = asRecord(await response.json(), `${vector.id} body`);
    const shares = body['shares'];
    if (!Array.isArray(shares)) throw new Error(`${vector.id}: shares is not an array`);
    expect(shares.length).toBe(expected['listed'] === true ? 1 : 0);
  });
});

describe('RunnableShareService reserves with the model limit', () => {
  it.each(visitorLimitVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const now = asNumber(input['now'], `${vector.id} now`);
    const base = shareRecord(asRecord(listingVectors[0]?.input, 'listing')['share'], 'share');
    const { sharing, reserveVisitorMessage } = fakeSharing();
    const service = new RunnableShareService(
      sharing,
      () => Promise.reject(new Error('not reached')),
      () => new Date(now),
    );
    const outcome = await service.message({ ...base, mode: 'runnable' }, 'Hello', 'visitor-1').then(
      () => 'ran',
      (error: unknown) => (error instanceof DomainError ? error.code : String(error)),
    );
    expect(outcome).toBe('share_unavailable');
    expect(reserveVisitorMessage).toHaveBeenCalledWith({
      id: base.id,
      visitorKey: 'visitor-1',
      windowStartedAt: new Date(now - asNumber(expected['windowMs'], vector.id)),
      now: new Date(now),
      limit: expected['limit'],
    });
  });
});
