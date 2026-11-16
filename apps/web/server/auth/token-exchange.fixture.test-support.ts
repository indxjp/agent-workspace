import {
  CONTROLLED_ENV,
  BASE_URL,
  ISSUER,
  AUDIENCE,
  startModelListServer,
} from './token-exchange.transport.test-support';
import crypto from 'node:crypto';
import { type Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  ID_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeResponseSchema,
} from '@indx-workspace/contracts/token-exchange';
import type { RegisteredComposition } from '../composition/register';
import { resetOAuthLimits } from '../oauth/limits';
import { toResponse } from '../rbac/http';
import { exchangeToken, resetTokenExchangeLimits, type IdTokenKeySource } from './token-exchange';

import {
  seedExchangePeople,
  configureExchange,
  prepareExchangeModel,
  installExchangeRunDelivery,
  createExchangeAgents,
  createExchangeClient,
} from './token-exchange.bootstrap.test-support';
export function createTokenExchangeFixture(env: NodeJS.ProcessEnv) {
  let isolated: IsolatedTestDatabase | undefined;
  let root: DatabaseRoot | undefined;
  let composition: RegisteredComposition | undefined;
  let modelListServer: Server | undefined;
  const previousEnv = new Map<string, string | undefined>();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const personUserId = crypto.randomUUID();
  const strangerUserId = crypto.randomUUID();
  let ownerPrincipalId = '';
  let grantedAgent = '';
  let ungrantedAgent = '';
  let unboundAgent = '';
  let clientId = '';
  let clientSecret = '';
  let source: IdTokenKeySource;
  let signingKey: CryptoKey;
  async function idToken(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: ISSUER,
      sub: subject,
      aud: AUDIENCE,
      iat: now - 5,
      exp: now + 600,
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(signingKey);
  }
  async function exchange(token: string): Promise<Response> {
    return toResponse(
      await exchangeToken(
        new Request(`${BASE_URL}/api/auth/token-exchange`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
          body: JSON.stringify({
            grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
            subject_token: token,
            subject_token_type: ID_TOKEN_TYPE,
          }),
        }),
        { loadKeySource: () => Promise.resolve(source) },
      ),
    );
  }
  async function accessToken(subject = 'person-sub'): Promise<string> {
    const response = await exchange(await idToken(subject));
    expect(response.status).toBe(200);
    return TokenExchangeResponseSchema.parse(await response.json()).access_token;
  }
  async function exchangeAudits(): Promise<(typeof auditEvents.$inferSelect)[]> {
    if (isolated === undefined) throw new Error('no database');
    return isolated.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          eq(auditEvents.action, 'user-token-exchanged'),
        ),
      );
  }
  beforeAll(async () => {
    for (const name of CONTROLLED_ENV) previousEnv.set(name, env[name]);

    const db = await createIsolatedTestDatabase('aw_token_exchange');

    isolated = db;
    const people = await seedExchangePeople(db, {
      workspaceId,
      otherWorkspaceId,
      ownerUserId,
      personUserId,
      strangerUserId,
    });
    ownerPrincipalId = people.ownerPrincipalId;
    composition = await configureExchange(env, db.url);

    root = await openDatabaseRoot({ DATABASE_URL: db.url });

    const modelList = await startModelListServer();

    modelListServer = modelList.server;
    const runnable = await prepareExchangeModel(db, workspaceId, modelList.url);
    installExchangeRunDelivery();
    ({ grantedAgent, ungrantedAgent, unboundAgent } = await createExchangeAgents(db, {
      workspaceId,
      personUserId,
      ownerKey: people.ownerKey.presented,
      ...runnable,
    }));
    ({ clientId, clientSecret } = await createExchangeClient(root, {
      workspaceId,
      ownerPrincipalId,
      grantedAgent,
      ungrantedAgent,
    }));

    const pair = await generateKeyPair('RS256', { extractable: true });

    signingKey = pair.privateKey;

    source = {
      issuer: ISSUER,
      algorithms: ['RS256'],
      keys: createLocalJWKSet({
        keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }],
      }),
    };
  }, 180_000);
  afterEach(() => {
    vi.useRealTimers();
    resetTokenExchangeLimits();
    resetOAuthLimits();
  });
  afterAll(async () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    if (modelListServer !== undefined) {
      const server = modelListServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await root?.close();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
  });
  return {
    get env() {
      return env;
    },
    get isolated() {
      return isolated;
    },
    get root() {
      return root;
    },
    get composition() {
      return composition;
    },
    get modelListServer() {
      return modelListServer;
    },
    get previousEnv() {
      return previousEnv;
    },
    get workspaceId() {
      return workspaceId;
    },
    get otherWorkspaceId() {
      return otherWorkspaceId;
    },
    get ownerUserId() {
      return ownerUserId;
    },
    get personUserId() {
      return personUserId;
    },
    get strangerUserId() {
      return strangerUserId;
    },
    get ownerPrincipalId() {
      return ownerPrincipalId;
    },
    get grantedAgent() {
      return grantedAgent;
    },
    get ungrantedAgent() {
      return ungrantedAgent;
    },
    get unboundAgent() {
      return unboundAgent;
    },
    get clientId() {
      return clientId;
    },
    get clientSecret() {
      return clientSecret;
    },
    get source() {
      return source;
    },
    get signingKey() {
      return signingKey;
    },
    get idToken() {
      return idToken;
    },
    get exchange() {
      return exchange;
    },
    get accessToken() {
      return accessToken;
    },
    get exchangeAudits() {
      return exchangeAudits;
    },
  };
}

export type TokenExchangeFixture = ReturnType<typeof createTokenExchangeFixture>;
