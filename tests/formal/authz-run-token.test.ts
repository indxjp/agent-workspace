import {
  authorizeToolCall,
  createGatewayApplication,
  type ToolConnectorResolver,
} from '@agent-workspace/gateway';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { createRunTokenCodec, type RunTokenSubject } from '@agent-workspace/gateway/tokens';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'authz-run-token';
const SECRET = 'formal-run-token-secret-at-least-thirty-two-bytes';
const claimsVectors = loadVectors(FAMILY, 'claims.json');
const issueVectors = loadVectors(FAMILY, 'issue.json');
const verifyVectors = loadVectors(FAMILY, 'verify.json');
const gatewayVectors = loadVectors(FAMILY, 'gateway.json');
const toolVectors = loadVectors(FAMILY, 'tools.json');

function number(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`${name}: expected number`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name}: expected boolean`);
  return value;
}

function subject(value: unknown): RunTokenSubject {
  const row = asRecord(value, 'subject');
  return {
    runId: asString(row['runId'], 'runId'),
    sessionId: asString(row['sessionId'], 'sessionId'),
    workspaceId: asString(row['workspaceId'], 'workspaceId'),
    agentId: asString(row['agentId'], 'agentId'),
    modelConnectionId: asString(row['modelConnectionId'], 'modelConnectionId'),
  };
}

const SUBJECT: RunTokenSubject = {
  runId: 'run-a',
  sessionId: 'session',
  workspaceId: 'workspace',
  agentId: 'agent',
  modelConnectionId: 'connection',
};

async function signedClaims(claims: object, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${Buffer.from(signature).toString('base64url')}`;
}

describe('authz-run-token: real HMAC codec', () => {
  it.each(claimsVectors)('$id', async ({ id, input, expected }) => {
    const claims = asRecord(input, id);
    const accepted = boolean(asRecord(expected, id)['accepted'], 'accepted');
    const token = await signedClaims(claims, SECRET);
    const codec = createRunTokenCodec({ secret: SECRET, now: () => 150 });
    const verdict = await codec.verify(token);
    expect(verdict.ok).toBe(accepted);
    if (!accepted && !verdict.ok) expect(verdict.reason).toBe('invalid');
  });

  it.each(issueVectors)('$id', async ({ id, input, expected }) => {
    const args = asRecord(input, id);
    const output = asRecord(expected, id)['claims'];
    const ttlSeconds = number(args['ttl'], 'ttl');
    if (ttlSeconds < 1 || ttlSeconds > 3600) {
      expect(() => createRunTokenCodec({ secret: SECRET, ttlSeconds })).toThrow();
      expect(output).toBeNull();
      return;
    }
    const codec = createRunTokenCodec({
      secret: SECRET,
      ttlSeconds,
      now: () => number(args['now'], 'now'),
      randomId: () => asString(args['tokenId'], 'tokenId'),
    });
    if (output === null) {
      await expect(codec.issue(subject(args['subject']))).rejects.toThrow();
      return;
    }
    const token = await codec.issue(subject(args['subject']));
    const verified = await codec.verify(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims).toEqual(output);
  });

  it.each(verifyVectors)('$id', async ({ id, input, expected }) => {
    const args = asRecord(input, id);
    const result = asString(asRecord(expected, id)['result'], 'result');
    const claims = {
      version: boolean(args['claimsValid'], 'claimsValid') ? 1 : 2,
      tokenId: 'token',
      ...SUBJECT,
      issuedAt: 100,
      expiresAt: 160,
    };
    const signatureSecret = boolean(args['signatureValid'], 'signatureValid')
      ? SECRET
      : 'different-signing-secret-at-least-thirty-two-bytes';
    const token = await signedClaims(claims, signatureSecret);
    const codec = createRunTokenCodec({ secret: SECRET, now: () => number(args['now'], 'now') });
    const verdict = await codec.verify(token);
    expect(verdict.ok ? 'valid' : verdict.reason).toBe(result);
  });
});

describe('authz-run-token: real gateway authentication', () => {
  it.each(gatewayVectors)('$id', async ({ id, input, expected }) => {
    const args = asRecord(input, id);
    const answer = asRecord(expected, id);
    const tokenState = asString(args['tokenState'], 'tokenState');
    const resolverState = asString(args['resolution'], 'resolution');
    const now = Math.floor(Date.now() / 1000);
    const token =
      tokenState === 'invalid'
        ? 'invalid.token'
        : await createRunTokenCodec({
            secret: SECRET,
            now: () => (tokenState === 'expired' ? 100 : now),
          }).issue(SUBJECT);
    let resolverCalled = false;
    const gateway = createGatewayApplication({
      tokenSecret: SECRET,
      providers: { fetch: () => Promise.resolve(Response.json({ ok: true })) },
      resolver: {
        resolve: () => {
          resolverCalled = true;
          switch (resolverState) {
            case 'revoked':
              return Promise.resolve({ state: 'revoked' });
            case 'deleted':
              return Promise.resolve({ state: 'deleted' });
            case 'missing':
              return Promise.resolve({ state: 'missing' });
            case 'active':
              return Promise.resolve({
                state: 'active',
                providerId: 'openai',
                connectionProvider: 'openai',
                credential: 'fixture-secret',
              });
            default:
              throw new Error(`${id}: unknown resolver state`);
          }
        },
      },
    });
    const response = await gateway.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: {
          ...(boolean(args['bearer'], 'bearer') ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'fixture', max_tokens: 8, messages: [] }),
      }),
    );
    expect(response.status).toBe(number(answer['status'], 'status'));
    if (answer['code'] === 'ok') {
      expect(resolverCalled).toBe(true);
      return;
    }
    expect(await response.json()).toEqual(answer['body']);
    if (tokenState !== 'valid' || !boolean(args['bearer'], 'bearer')) {
      expect(resolverCalled).toBe(false);
    }
  });
});

/** An `openapi` config; an allowed call only has to reach the MCP layer, never the upstream. */
const TOOL_CONFIG = OpenApiToolConfigSchema.parse({
  spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 1 },
  baseUrl: 'https://tools.example.test/api',
  auth: 'none',
  allow: ['GET /**'],
  operations: [{ name: 'listPets', method: 'GET', path: '/pets' }],
});

describe('authz-run-token: real tool-route authorisation (C16)', () => {
  it.each(toolVectors)('$id', async ({ id, input, expected }) => {
    const args = asRecord(input, id);
    const answer = asRecord(expected, id);
    const tokenState = asString(args['tokenState'], 'tokenState');
    const connectorId = asString(args['connectorId'], 'connectorId');
    const run = args['run'] === null ? null : asRecord(args['run'], 'run');
    const connector = asRecord(args['connector'], 'connector');
    const kind = asString(connector['kind'], 'kind');
    if (kind !== 'openapi' && kind !== 'postgres') throw new Error(`${id}: unknown kind`);
    const now = Math.floor(Date.now() / 1000);
    const token =
      tokenState === 'invalid'
        ? 'invalid.token'
        : await createRunTokenCodec({
            secret: SECRET,
            now: () => (tokenState === 'expired' ? 100 : now),
          }).issue({ ...SUBJECT, workspaceId: asString(args['workspaceId'], 'workspaceId') });
    let toolsCalled = false;
    let modelResolverCalled = false;
    const tools: ToolConnectorResolver = {
      resolve: (claims, _tokenHash, requested) => {
        toolsCalled = true;
        const decision = authorizeToolCall({
          tokenActive: boolean(args['tokenActive'], 'tokenActive'),
          run:
            run === null
              ? null
              : {
                  status: boolean(run['terminal'], 'terminal') ? 'completed' : 'running',
                  toolConnectorIds: (run['toolConnectorIds'] as unknown[]).map((value) =>
                    asString(value, 'toolConnectorIds'),
                  ),
                },
          connector: {
            workspaceId: asString(connector['workspaceId'], 'connector.workspaceId'),
            kind,
            enabled: boolean(connector['enabled'], 'enabled'),
          },
          workspaceId: claims.workspaceId,
          connectorId: requested,
        });
        return Promise.resolve(
          decision.ok
            ? {
                ok: true,
                connector: {
                  config: TOOL_CONFIG,
                  parameters: {},
                  credential: () => Promise.resolve(null),
                },
              }
            : decision,
        );
      },
    };
    const gateway = createGatewayApplication({
      tokenSecret: SECRET,
      resolver: {
        resolve: () => {
          modelResolverCalled = true;
          return Promise.resolve({ state: 'missing' });
        },
      },
      tools,
    });
    const response = await gateway.fetch(
      new Request(`http://gateway/v1/tools/${connectorId}/mcp`, {
        method: 'POST',
        headers: {
          ...(tokenState === 'missing' ? {} : { authorization: `Bearer ${token}` }),
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'formal-replay', version: '1.0.0' },
          },
        }),
      }),
    );
    expect(response.status).toBe(number(answer['status'], 'status'));
    expect(modelResolverCalled).toBe(false);
    expect(toolsCalled).toBe(tokenState === 'valid');
    if (answer['code'] === 'ok') return;
    const body = asRecord(await response.json(), 'body');
    expect(asRecord(body['error'], 'error')['code']).toBe(answer['code']);
  });
});
