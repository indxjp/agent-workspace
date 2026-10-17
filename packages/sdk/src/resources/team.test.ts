import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import {
  ApiKeysClient,
  InvitationsClient,
  MembersClient,
  TeamClient,
  UsersClient,
} from './team.js';

const MEMBERSHIP = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const INVITATION = '7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f';
const API_KEY = '88888888-8888-4888-8888-888888888888';
const PRESENTED = 'ak_live_AbCdEfGhIjKlMnOpQrStUv_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const TOKEN = 'aG9yc2UtYmF0dGVyeS1zdGFwbGU';

const membership = {
  id: MEMBERSHIP,
  principalId: '33333333-3333-4333-8333-333333333333',
  userId: USER,
  email: 'aya.ito@example.test',
  name: 'Aya Ito',
  role: 'builder',
  createdAt: '2026-09-12T00:00:00.000Z',
};

const user = {
  id: USER,
  email: membership.email,
  name: membership.name,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const invitation = {
  id: INVITATION,
  email: 'new.person@example.test',
  role: 'viewer',
  invitedBy: USER,
  expiresAt: '2026-09-28T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-21T12:00:00.000Z',
};

const issued = {
  invitation,
  token: TOKEN,
  link: `/accept-invitation?id=${INVITATION}&token=${TOKEN}`,
  warning: 'This is the only time this token is shown.',
};

const apiKey = {
  id: API_KEY,
  name: 'ci-deploy',
  role: 'builder',
  keyPrefix: 'ak_live_AbCdEfGhIjKlMnOpQrStUv',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
};

/** The `{ code, detail }` spelling an older deployment's team routes answer (spec 04 §4, ADR-0075). */
const problem = (status: number, code: string) => json(status, { error: { code, detail: code } });

function client(
  route: (request: RecordedRequest) => Response | Promise<Response>,
  auth: 'api-key' | 'session' = 'api-key',
): { readonly team: TeamClient; readonly calls: RecordedRequest[] } {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: auth === 'api-key' ? { kind: 'api-key', apiKey: 'ak_live_k' } : { kind: 'session' },
    fetch: api.fetch,
  });
  return { team: new TeamClient(http), calls: api.calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectProblem(error: unknown, status: number, code: string): void {
  expect(error).toBeInstanceOf(ApiProblemError);
  expect((error as ApiProblemError).status).toBe(status);
  expect((error as ApiProblemError).code).toBe(code);
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const rejectAborted = (): Promise<Response> =>
  Promise.reject(new DOMException('aborted', 'AbortError'));

describe('TeamClient', () => {
  it('exposes one client per principal kind', () => {
    const { team } = client(() => json(200, {}));
    expect(team.members).toBeInstanceOf(MembersClient);
    expect(team.users).toBeInstanceOf(UsersClient);
    expect(team.invitations).toBeInstanceOf(InvitationsClient);
    expect(team.apiKeys).toBeInstanceOf(ApiKeysClient);
  });

  it('reads code and prose from the `detail` envelope an older deployment’s rbac routes answer', async () => {
    // Before SDK unit 6 (#238) `problem()` rendered `{ error: { code, detail } }`; the client maps
    // `detail` onto `message` so the code stays readable.
    const { team } = client(() =>
      json(404, { error: { code: 'no_such_membership', detail: 'No membership x.' } }),
    );
    const error = await failure(team.members.setRole(MEMBERSHIP, 'viewer'));
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).status).toBe(404);
    expect((error as ApiProblemError).code).toBe('no_such_membership');
    expect((error as ApiProblemError).message).toBe('No membership x.');
  });
});

describe('TeamClient.members', () => {
  it('lists with the bearer and unwraps the envelope', async () => {
    const { team, calls } = client(() => json(200, { memberships: [membership] }));
    expect(await team.members.list()).toEqual([membership]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.href).toBe('https://aw.example.com/api/memberships');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(calls[0]?.json).toBeUndefined();
  });

  it('adds with exactly { email, role } and reads the wrapped 201', async () => {
    const { team, calls } = client(() => json(201, { membership }));
    const input = { email: 'Aya.Ito@example.test', role: 'builder' as const, name: 'ignored' };
    expect(await team.members.add(input)).toEqual(membership);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/memberships');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.json).toEqual({ email: 'Aya.Ito@example.test', role: 'builder' });
  });

  it('surfaces the add refusals by code', async () => {
    const input = { email: 'x@example.test', role: 'owner' as const };
    expectProblem(
      await failure(client(() => problem(404, 'no_such_user')).team.members.add(input)),
      404,
      'no_such_user',
    );
    expectProblem(
      await failure(client(() => problem(409, 'already_a_member')).team.members.add(input)),
      409,
      'already_a_member',
    );
    expectProblem(
      await failure(client(() => problem(403, 'forbidden_role_conferral')).team.members.add(input)),
      403,
      'forbidden_role_conferral',
    );
    expectProblem(
      await failure(client(() => problem(400, 'invalid_field')).team.members.add(input)),
      400,
      'invalid_field',
    );
    expectProblem(
      await failure(client(() => problem(403, 'forbidden')).team.members.list()),
      403,
      'forbidden',
    );
    expectProblem(
      await failure(client(() => problem(503, 'rbac_runtime_not_configured')).team.members.list()),
      503,
      'rbac_runtime_not_configured',
    );
  });

  it('patches { role } to the percent-encoded id and unwraps the 200', async () => {
    const promoted = { ...membership, role: 'admin' };
    const { team, calls } = client(() => json(200, { membership: promoted }));
    expect(await team.members.setRole('../x?y#z', 'admin')).toEqual(promoted);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe('/api/memberships/..%2Fx%3Fy%23z');
    expect(calls[0]?.url.search).toBe('');
    expect(calls[0]?.json).toEqual({ role: 'admin' });
  });

  it('surfaces the last owner and the undecidable conferral on setRole', async () => {
    expectProblem(
      await failure(
        client(() => problem(409, 'last_owner')).team.members.setRole(MEMBERSHIP, 'viewer'),
      ),
      409,
      'last_owner',
    );
    expectProblem(
      await failure(
        client(() => problem(500, 'authorisation_undecidable')).team.members.setRole(
          MEMBERSHIP,
          'viewer',
        ),
      ),
      500,
      'authorisation_undecidable',
    );
  });

  it('removes with DELETE and resolves on 204', async () => {
    const { team, calls } = client(() => json(204, null));
    await expect(team.members.remove(MEMBERSHIP)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/api/memberships/${MEMBERSHIP}`);
    expect(calls[0]?.json).toBeUndefined();
  });

  it('surfaces the three removal refusals by code', async () => {
    for (const [status, code] of [
      [404, 'no_such_membership'],
      [409, 'last_owner'],
      [409, 'membership_in_use'],
    ] as const) {
      expectProblem(
        await failure(client(() => problem(status, code)).team.members.remove(MEMBERSHIP)),
        status,
        code,
      );
    }
  });

  it('refuses a list item that carries an unknown field, and a bare 201', async () => {
    const drifted = client(() => json(200, { memberships: [{ ...membership, keyHash: 'x' }] }));
    const error = await failure(drifted.team.members.list());
    expect(error).toBeInstanceOf(ContractViolationError);
    expect((error as ContractViolationError).issues.join('\n')).toContain('keyHash');

    const bare = client(() => json(201, membership));
    expect(
      await failure(bare.team.members.add({ email: 'a@b.test', role: 'viewer' })),
    ).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const { team, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return rejectAborted();
    });
    const error = await failure(team.members.remove(MEMBERSHIP, { signal: abortedSignal() }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('TeamClient.users', () => {
  it('lists and unwraps', async () => {
    const { team, calls } = client(() => json(200, { users: [user] }));
    expect(await team.users.list()).toEqual([user]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/users');
  });

  it('creates with exactly { email, name, role } and returns both rows of the 201', async () => {
    const { team, calls } = client(() => json(201, { user, membership }));
    const created = await team.users.create({
      email: user.email,
      name: user.name,
      role: 'builder',
    });
    expect(created).toEqual({ user, membership });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/users');
    expect(calls[0]?.json).toEqual({ email: user.email, name: user.name, role: 'builder' });
  });

  it('surfaces the create refusals by code', async () => {
    const input = { email: user.email, name: user.name, role: 'owner' as const };
    expectProblem(
      await failure(client(() => problem(409, 'email_taken')).team.users.create(input)),
      409,
      'email_taken',
    );
    expectProblem(
      await failure(
        client(() => problem(403, 'forbidden_role_conferral')).team.users.create(input),
      ),
      403,
      'forbidden_role_conferral',
    );
    expectProblem(
      await failure(client(() => problem(400, 'invalid_field')).team.users.create(input)),
      400,
      'invalid_field',
    );
    expectProblem(
      await failure(client(() => problem(400, 'malformed_body')).team.users.create(input)),
      400,
      'malformed_body',
    );
  });

  it('refuses a 201 without the membership, and reports an abort', async () => {
    const partial = client(() => json(201, { user }));
    const input = { email: user.email, name: user.name, role: 'viewer' as const };
    const drift = await failure(partial.team.users.create(input));
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).status).toBe(201);

    const aborted = await failure(
      client(rejectAborted).team.users.create(input, { signal: abortedSignal() }),
    );
    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
  });
});

describe('TeamClient.invitations', () => {
  it('lists with the cookie and no bearer, and unwraps', async () => {
    const { team, calls } = client(() => json(200, { invitations: [invitation] }), 'session');
    expect(await team.invitations.list()).toEqual([invitation]);
    expect(calls[0]?.url.pathname).toBe('/api/invitations');
    expect(calls[0]?.headers.has('authorization')).toBe(false);
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('creates with exactly { email, role } and returns the one-time token, link and warning', async () => {
    const { team, calls } = client(() => json(201, issued), 'session');
    const input = { email: invitation.email, role: 'viewer' as const, name: 'not accepted' };
    expect(await team.invitations.create(input)).toEqual(issued);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/invitations');
    expect(calls[0]?.json).toEqual({ email: invitation.email, role: 'viewer' });
  });

  it('surfaces the invitation refusals by code', async () => {
    const input = { email: invitation.email, role: 'viewer' as const };
    expectProblem(
      await failure(client(() => problem(409, 'already_invited')).team.invitations.create(input)),
      409,
      'already_invited',
    );
    expectProblem(
      await failure(
        client(() => problem(403, 'api_key_not_permitted')).team.invitations.create(input),
      ),
      403,
      'api_key_not_permitted',
    );
    expectProblem(
      await failure(
        client(() => problem(503, 'invitations_runtime_not_configured')).team.invitations.list(),
      ),
      503,
      'invitations_runtime_not_configured',
    );
    expectProblem(
      await failure(client(() => problem(400, 'invalid_field')).team.invitations.create(input)),
      400,
      'invalid_field',
    );
  });

  it('resends with POST to /resend, no body, and reads the rotated token', async () => {
    const rotated = {
      ...issued,
      token: 'bmV3LXRva2Vu',
      warning: 'The previous token no longer works.',
    };
    const { team, calls } = client(() => json(200, rotated), 'session');
    expect(await team.invitations.resend(INVITATION)).toEqual(rotated);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/invitations/${INVITATION}/resend`);
    expect(calls[0]?.json).toBeUndefined();
    expect(calls[0]?.headers.has('content-type')).toBe(false);
  });

  it('surfaces the resend and revoke refusals by code', async () => {
    for (const [status, code] of [
      [404, 'no_such_invitation'],
      [409, 'already_accepted'],
      [409, 'invitation_revoked'],
      [400, 'invalid_field'],
      [500, 'authorisation_undecidable'],
    ] as const) {
      expectProblem(
        await failure(client(() => problem(status, code)).team.invitations.resend(INVITATION)),
        status,
        code,
      );
    }
    expectProblem(
      await failure(
        client(() => problem(409, 'already_accepted')).team.invitations.revoke(INVITATION),
      ),
      409,
      'already_accepted',
    );
  });

  it('revokes with DELETE, encodes the id, and unwraps the 200 row', async () => {
    const revoked = { ...invitation, revokedAt: '2026-09-22T09:00:00.000Z' };
    const { team, calls } = client(() => json(200, { invitation: revoked }), 'session');
    expect(await team.invitations.revoke('a b/c')).toEqual(revoked);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/invitations/a%20b%2Fc');
  });

  it('accepts with exactly { token } and reads the workspace and the principal-bearing membership', async () => {
    const joined = { ...membership, role: 'viewer' };
    const { team, calls } = client(
      () => json(200, { workspaceId: '44444444-4444-4444-8444-444444444444', membership: joined }),
      'session',
    );
    const accepted = await team.invitations.accept(INVITATION, TOKEN);
    expect(accepted.membership.principalId).toBe(membership.principalId);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/invitations/${INVITATION}/accept`);
    expect(calls[0]?.json).toEqual({ token: TOKEN });
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('surfaces every accept refusal by code', async () => {
    for (const [status, code] of [
      [404, 'invitation_not_valid'],
      [410, 'invitation_expired'],
      [410, 'invitation_revoked'],
      [409, 'invitation_already_used'],
      [409, 'already_a_member'],
      [401, 'invitation_identity_required'],
      [403, 'cross_origin'],
      [503, 'server_not_configured'],
    ] as const) {
      expectProblem(
        await failure(
          client(() => problem(status, code), 'session').team.invitations.accept(INVITATION, TOKEN),
        ),
        status,
        code,
      );
    }
  });

  it('refuses an issued body that lost its token, and a list row that gained one', async () => {
    const withoutToken = Object.fromEntries(
      Object.entries(issued).filter(([key]) => key !== 'token'),
    );
    const lost = await failure(
      client(() => json(201, withoutToken), 'session').team.invitations.create({
        email: invitation.email,
        role: 'viewer',
      }),
    );
    expect(lost).toBeInstanceOf(ContractViolationError);
    expect((lost as ContractViolationError).issues.join('\n')).toContain('token');

    const leaked = await failure(
      client(
        () => json(200, { invitations: [{ ...invitation, token: TOKEN }] }),
        'session',
      ).team.invitations.list(),
    );
    expect(leaked).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const error = await failure(
      client(rejectAborted, 'session').team.invitations.resend(INVITATION, {
        signal: abortedSignal(),
      }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});

describe('TeamClient.apiKeys', () => {
  it('lists and unwraps, and refuses a row that carries a secret under any name', async () => {
    const { team, calls } = client(() => json(200, { apiKeys: [apiKey] }));
    expect(await team.apiKeys.list()).toEqual([apiKey]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/api-keys');

    for (const field of ['key', 'secret', 'keyHash']) {
      const leaked = client(() => json(200, { apiKeys: [{ ...apiKey, [field]: PRESENTED }] }));
      const error = await failure(leaked.team.apiKeys.list());
      expect(error, field).toBeInstanceOf(ContractViolationError);
      expect((error as ContractViolationError).issues.join('\n')).toContain(field);
    }
  });

  it('mints with { name, role, expiresAt } — null when omitted — and returns the key once', async () => {
    const minted = { apiKey, key: PRESENTED, warning: 'This is the only time this key is shown.' };
    const { team, calls } = client(() => json(201, minted));
    const created = await team.apiKeys.create({ name: 'ci-deploy', role: 'builder' });
    expect(created.key).toBe(PRESENTED);
    expect(created.apiKey).toEqual(apiKey);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/api-keys');
    expect(calls[0]?.json).toEqual({ name: 'ci-deploy', role: 'builder', expiresAt: null });

    await team.apiKeys.create({
      name: 'ci-deploy',
      role: 'builder',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(calls[1]?.json).toEqual({
      name: 'ci-deploy',
      role: 'builder',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('surfaces the mint refusals by code', async () => {
    const input = { name: 'ci-deploy', role: 'owner' as const };
    expectProblem(
      await failure(client(() => problem(409, 'name_taken')).team.apiKeys.create(input)),
      409,
      'name_taken',
    );
    expectProblem(
      await failure(
        client(() => problem(403, 'forbidden_role_conferral')).team.apiKeys.create(input),
      ),
      403,
      'forbidden_role_conferral',
    );
    expectProblem(
      await failure(client(() => problem(400, 'invalid_field')).team.apiKeys.create(input)),
      400,
      'invalid_field',
    );
    expectProblem(
      await failure(client(() => problem(401, 'unauthenticated')).team.apiKeys.create(input)),
      401,
      'unauthenticated',
    );
  });

  it('refuses a 201 whose key is not a whole key, or whose resource repeats it', async () => {
    const input = { name: 'ci-deploy', role: 'viewer' as const };
    const truncated = client(() => json(201, { apiKey, key: apiKey.keyPrefix, warning: 'once' }));
    expect(await failure(truncated.team.apiKeys.create(input))).toBeInstanceOf(
      ContractViolationError,
    );
    const repeated = client(() =>
      json(201, { apiKey: { ...apiKey, key: PRESENTED }, key: PRESENTED, warning: 'once' }),
    );
    expect(await failure(repeated.team.apiKeys.create(input))).toBeInstanceOf(
      ContractViolationError,
    );
  });

  it('revokes with DELETE, encodes the id, and unwraps the 200 row', async () => {
    const revoked = { ...apiKey, revokedAt: '2026-09-21T12:00:00.000Z' };
    const { team, calls } = client(() => json(200, { apiKey: revoked }));
    expect(await team.apiKeys.revoke('k/1')).toEqual(revoked);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/api-keys/k%2F1');
    expect(calls[0]?.json).toBeUndefined();
  });

  it('surfaces a missing key, and refuses a 204 where the row was promised', async () => {
    expectProblem(
      await failure(client(() => problem(404, 'no_such_api_key')).team.apiKeys.revoke(API_KEY)),
      404,
      'no_such_api_key',
    );
    expectProblem(
      await failure(client(() => json(204, null)).team.apiKeys.revoke(API_KEY)),
      204,
      'unrecognised_error_body',
    );
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const error = await failure(
      client(rejectAborted).team.apiKeys.create(
        { name: 'x', role: 'viewer' },
        { signal: abortedSignal() },
      ),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});
