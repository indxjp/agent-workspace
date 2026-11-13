import { fixtures } from '@indx-workspace/sdk/testing';

import { describe, expect, it } from 'vitest';

import {
  AGENT,
  CODE_TOOL_PROJECT,
  start,
  synced,
  until,
  writes,
} from './sync.fixture.test-support.js';
describe('startDevSync registers the tool host (issue #693, ADR-0115)', () => {
  const HOST = { url: 'http://127.0.0.1:4100/tok/mcp' };

  it('creates the local-only aw-dev-tools connector before the first version', async () => {
    const harness = await start(CODE_TOOL_PROJECT, undefined, {}, HOST);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/connectors', 'POST /api/agents']);
    const created = harness.calls.find((call) => call.method === 'POST');
    expect(created?.json).toEqual({ name: 'aw-dev-tools', transport: 'http', url: HOST.url });
  });

  it('points the connector at the new URL when aw dev starts again', async () => {
    const harness = await start(
      CODE_TOOL_PROJECT,
      (state) => {
        state.connectors.push(
          fixtures.connector({
            name: 'aw-dev-tools',
            url: 'http://127.0.0.1:1/old/mcp',
            authType: 'none',
            hasCredential: false,
          }),
        );
      },
      {},
      HOST,
    );
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual([
      expect.stringMatching(/^PATCH \/api\/connectors\//u),
      'POST /api/agents',
    ]);
    expect(harness.state.connectors[0]?.url).toBe(HOST.url);
  });

  it.each([
    ['a credential', { authType: 'bearer', hasCredential: true }],
    ['a non-loopback URL', { url: 'https://crm.example.com/mcp' }],
  ] as const)(
    'refuses to re-point a pre-existing aw-dev-tools connector with %s',
    async (_label, overrides) => {
      const harness = await start(
        CODE_TOOL_PROJECT,
        (state) => {
          state.connectors.push(
            fixtures.connector({
              name: 'aw-dev-tools',
              url: 'http://127.0.0.1:1/old/mcp',
              authType: 'none',
              hasCredential: false,
              ...overrides,
            }),
          );
        },
        {},
        HOST,
      );
      await until(harness, () => harness.output().stderr.includes('sync: 1 problem'));
      expect(writes(harness)).toEqual([]);
      expect(harness.state.connectors[0]?.url).not.toBe(HOST.url);
      expect(harness.output().stdout).toContain(
        'tool_host_connector_conflict [connector:aw-dev-tools]',
      );
      expect(harness.output().stdout).toContain('rename or delete it');
    },
  );

  it('registers nothing when the project has no code tool', async () => {
    const harness = await start({ 'agents/assistant.ts': AGENT }, undefined, {}, HOST);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents']);
  });
});
