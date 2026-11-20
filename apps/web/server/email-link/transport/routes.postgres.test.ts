/**
 * The email-link sign-in over a real PostgreSQL: the same issue and verify, then `GET /api/me`
 * through the production session resolver, to see who the cookie signs in as. The rig is in
 * `routes.test-support.ts`.
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as getMe } from '../../../app/api/me/route';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { fixedClock } from '../../clock';
import { createPostgresDirectory } from '../../rbac/postgres-directory';
import { FakeChallengeVerifier } from '../adapters/challenge/fake';
import { createDisposableEmailList } from '../adapters/disposable/disposable';
import { createGuestWorkspaceBinder } from '../adapters/guest-workspace/production';
import { MemoryLoginTokenStore } from '../adapters/login-tokens/memory';
import { FakeEmailLinkSender } from '../adapters/sender/fake';
import { createEmailLinkServiceFrom } from '../service';
import type { EmailLinkRuntime } from './routes';
import {
  CHALLENGE,
  HOST,
  SECRET,
  STORE_ORIGIN,
  issue,
  sessionCookieOf,
  tokenOf,
  verify,
} from './routes.test-support';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('email-link sign-in over a real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let database: DatabaseRoot;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_email_link_routes');
    database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await database.close();
    await isolated.close();
  });

  beforeEach(() => {
    clearApplicationContext();
  });
  afterEach(() => {
    clearApplicationContext();
  });

  /** A runtime over the production binder and the database's directory. */
  function postgresRuntime(sender: FakeEmailLinkSender): EmailLinkRuntime {
    const directory = createPostgresDirectory(database.directory);
    const clock = fixedClock(new Date());
    const ids = { newId: () => crypto.randomUUID() };
    return {
      kind: 'ready',
      clock,
      service: createEmailLinkServiceFrom({
        clock,
        ids,
        clientIdentity: { trustedProxyHops: 1, sessionSecret: SECRET },
        store: new MemoryLoginTokenStore(),
        binder: createGuestWorkspaceBinder({ directory, ids }),
        sender,
        linkBaseUrl: STORE_ORIGIN,
        challenge: new FakeChallengeVerifier(CHALLENGE),
        disposable: createDisposableEmailList(),
      }),
    };
  }

  it('signs the guest in so that the production session resolver answers role guest in the demo workspace', async () => {
    const { installRbacApi } = await import('../../composition/session-rbac');
    const installed = await installRbacApi(database, SECRET);
    const sender = new FakeEmailLinkSender();
    const runtime = postgresRuntime(sender);
    const email = `pg-guest-${crypto.randomUUID().slice(0, 8)}@example.test`;
    expect((await issue(runtime, email)).status).toBe(202);
    const response = await verify(runtime, { email, token: tokenOf(sender) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspaceId: string; workspaceSlug: string };
    const cookie = sessionCookieOf(response);
    if (cookie === null) throw new Error('no session cookie');

    installTestDomains({ rbac: installed.rbac });
    const me = await getMe(new Request(`https://${HOST}/api/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: 'guest', workspaceId: body.workspaceId });
  });
});
