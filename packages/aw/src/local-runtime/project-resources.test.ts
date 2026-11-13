import { readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import { FIXTURES, json, tempFile } from '../testing.js';

import {
  FINGERPRINTS,
  KEY,
  TOKEN,
  YAML,
  apply,
  existing,
  freshRoot,
  rotations,
} from './project-resources.fixture.test-support.js';
describe('applyProjectResources', () => {
  it('records each fingerprint after its send, and sends nothing again while it matches', async () => {
    const root = await freshRoot();
    const env = { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN };
    const first = await apply({ root: root, env: env, answer: existing });
    expect(rotations(first.sent)).toEqual([
      `POST /api/model-connections/${FIXTURES.modelConnection.id}/credential`,
      `PATCH /api/connectors/${FIXTURES.connector.id}`,
    ]);
    const file = await readFile(path.join(root, FINGERPRINTS), 'utf8');
    expect(file).not.toContain(KEY);
    expect(file).not.toContain(TOKEN);
    expect(rotations((await apply({ root: root, env: env, answer: existing })).sent)).toEqual([]);
  });

  it('sends the identity a connector declares, which the server resolves from the workspace secret (ADR-0142)', async () => {
    const root = await freshRoot();
    const yaml = YAML.replace(
      '  github:\n    url: https://mcp.example.com\n',
      '  github:\n    url: https://mcp.example.com\n    identity:\n      secret: CRM_IDENTITY_SECRET\n',
    );
    const { sent, stderr } = await apply({
      root: root,
      env: { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      answer: (route) => {
        if (route === 'GET /api/connectors') return json(200, { connectors: [] });
        if (route === 'POST /api/connectors') return json(201, FIXTURES.connector);
        return existing(route);
      },
      yaml: yaml,
    });
    const created = sent.find((request) => request.route === 'POST /api/connectors');
    expect(JSON.parse(created?.body ?? 'null')).toMatchObject({
      name: 'github',
      identity: { secret: 'CRM_IDENTITY_SECRET' },
    });
    expect(stderr).not.toContain('identity');
  });

  it('treats a malformed fingerprint file as nothing recorded, and rotates', async () => {
    const root = await freshRoot();
    await tempFile(root, FINGERPRINTS, '{ "key": "not base64", "fingerprints": {} }');
    const { sent } = await apply({
      root: root,
      env: { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      answer: existing,
    });
    expect(rotations(sent)).toHaveLength(2);
    await writeFile(path.join(root, FINGERPRINTS), 'not json');
    expect(
      rotations(
        (await apply({ root: root, env: { ANTHROPIC_API_KEY: KEY }, answer: existing })).sent,
      ),
    ).toHaveLength(1);
  });

  it('says nothing about a 409 on a create: another aw dev made it first', async () => {
    const root = await freshRoot();
    const { stderr, stdout } = await apply({
      root: root,
      env: { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      answer: (route) => {
        if (route.startsWith('GET '))
          return json(200, route.includes('model') ? { models: [] } : { connectors: [] });
        return json(409, { error: { code: 'name_conflict', message: 'taken' } });
      },
    });
    expect(stderr).toBe('');
    expect(stdout).toBe('');
  });

  it('warns about a refused rotation and goes on with the next resource, printing no value', async () => {
    const root = await freshRoot();
    const { sent, stderr, stdout } = await apply({
      root: root,
      env: { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      answer: (route) =>
        route.endsWith('/credential')
          ? json(400, { error: { code: 'invalid_credential', message: 'refused' } })
          : existing(route),
    });
    expect(stderr).toContain('warning: could not set up the "default" model connection: ');
    expect(rotations(sent)).toContain(`PATCH /api/connectors/${FIXTURES.connector.id}`);
    expect(stdout).toContain('applied: connector github (updated)\n');
    expect(stdout).toContain(
      'connectors.github: MCP tools that write run without confirmation (ADR-0108)\n',
    );
    expect(stdout + stderr).not.toContain(KEY);
    expect(stdout + stderr).not.toContain(TOKEN);
    // Only the connector's fingerprint was recorded: the refused key is sent again next time.
    const recorded = z
      .object({ fingerprints: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await readFile(path.join(root, FINGERPRINTS), 'utf8')));
    expect(Object.keys(recorded.fingerprints)).toEqual(['ORDERS_TOKEN']);
  });

  it('records a shared secret only once every resource naming it took the value (SD16)', async () => {
    const root = await freshRoot();
    const fastId = '0b4c3a52-8d6f-4f0e-9a1b-2c3d4e5f6a7b';
    const shared = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  default:
    provider: anthropic
    credential:
      secret: ANTHROPIC_API_KEY
  fast:
    provider: anthropic
    credential:
      secret: ANTHROPIC_API_KEY
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
    const both = (failFast: boolean) => (route: string) => {
      if (route === 'GET /api/model-connections') {
        return json(200, {
          models: [
            { ...FIXTURES.modelConnection, name: 'default' },
            { ...FIXTURES.modelConnection, id: fastId, name: 'fast' },
          ],
        });
      }
      if (failFast && route === `POST /api/model-connections/${fastId}/credential`) {
        return json(500, { error: { code: 'internal', message: 'boom' } });
      }
      return existing(route);
    };
    const env = { ANTHROPIC_API_KEY: KEY };
    const first = await apply({ root: root, env: env, answer: both(true), yaml: shared });
    expect(first.stderr).toContain('warning: could not set up the "fast" model connection: ');
    // The second send failed, so nothing is recorded and the next start sends both again.
    const second = await apply({ root: root, env: env, answer: both(false), yaml: shared });
    expect(rotations(second.sent)).toEqual([
      `POST /api/model-connections/${FIXTURES.modelConnection.id}/credential`,
      `POST /api/model-connections/${fastId}/credential`,
    ]);
    expect(
      rotations((await apply({ root: root, env: env, answer: both(false), yaml: shared })).sent),
    ).toEqual([]);
  });
});
