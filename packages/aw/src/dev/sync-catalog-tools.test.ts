import { fixtures } from '@indx-workspace/sdk/testing';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { IDS, tempFile } from '../testing.js';

import {
  DEBOUNCE_MS,
  filesUnder,
  first,
  ordersDocument,
  ordersTool,
  SENTINEL,
  start,
  synced,
  TOOL_PROJECT,
  toolAgent,
  until,
  writeIndex,
  writes,
} from './sync.fixture.test-support.js';
describe('startDevSync applies catalog tools (issue #549)', () => {
  it('creates the connector before the first version, and the token is in no file and no log line', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/connectors', 'POST /api/agents']);
    const created = harness.calls.find(
      (call) => call.method === 'POST' && call.path === '/api/connectors',
    );
    expect(created?.json).toMatchObject({ kind: 'openapi', name: 'orders', credential: SENTINEL });

    const { stdout, stderr } = harness.output();
    expect(`${stdout}${stderr}`).not.toContain(SENTINEL);
    for (const file of await filesUnder(harness.root)) {
      expect(await readFile(file, 'utf8'), file).not.toContain(SENTINEL);
    }
    const carrying = harness.calls.filter((call) =>
      JSON.stringify(call.json ?? null).includes(SENTINEL),
    );
    expect(carrying).toEqual([created]);
  });

  it('updates the connector before the version push when the document and agent change', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);
    const connectorId = harness.state.connectors[0]?.id ?? '';

    await tempFile(harness.root, 'apis/orders.openapi.json', ordersDocument('2'));
    await tempFile(harness.root, 'agents/assistant.ts', toolAgent('Help people kindly.'));
    await until(harness, () => synced(harness) === 2);
    const patch = writeIndex(harness, `PATCH /api/connectors/${connectorId}`);
    const version = writeIndex(harness, `POST /api/agents/${IDS.agent}/versions`);
    expect(patch).toBeGreaterThan(0);
    expect(version).toBeGreaterThan(patch);
    const sent = harness.calls.find((call) => call.method === 'PATCH');
    expect(sent?.json).toMatchObject({ document: ordersDocument('2') });
  });

  it('updates the connector on a document-only edit, saving no version', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'apis/orders.openapi.json', ordersDocument('3'));
    await until(harness, () => writes(harness).some((write) => write.startsWith('PATCH ')));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(first(harness).versions).toHaveLength(1);
    expect(writes(harness).filter((write) => write.startsWith('PATCH '))).toHaveLength(1);
  });

  it('updates the connector when tools/orders.ts changes its allow rules', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'tools/orders.ts', ordersTool(`['GET /orders/*', 'GET /orders']`));
    await until(harness, () => writes(harness).some((write) => write.startsWith('PATCH ')));
    expect(harness.state.connectors[0]?.openapi?.allow).toEqual(['GET /orders/*', 'GET /orders']);
  });

  it('prints the C10 notice when ORDERS_TOKEN is unset, creates no connector and keeps running', async () => {
    const harness = await start(TOOL_PROJECT);
    await until(harness, () => synced(harness) === 1);
    expect(harness.output().stderr).toBe(
      'notice: ORDERS_TOKEN is not set: run export ORDERS_TOKEN=… in the shell aw dev started from, then restart aw dev\n',
    );
    expect(writes(harness)).toEqual(['POST /api/agents']);

    await tempFile(harness.root, 'agents/assistant.ts', toolAgent('Help people again.'));
    await until(harness, () => synced(harness) === 2);
    expect(harness.fatal).toEqual([]);
    expect(harness.output().stderr).toBe(
      'notice: ORDERS_TOKEN is not set: run export ORDERS_TOKEN=… in the shell aw dev started from, then restart aw dev\n',
    );
  });

  it('refuses a tool whose name an MCP connector holds, and pushes no agent', async () => {
    const harness = await start(
      TOOL_PROJECT,
      (state) => {
        state.connectors.push(fixtures.connector({ name: 'orders' }));
      },
      { ORDERS_TOKEN: SENTINEL },
    );
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output().stdout).toBe(
      'tools/orders.ts: local tool_refused [a connector of this name exists as http, not openapi; rename one]\n',
    );
    expect(writes(harness)).toEqual([]);
    expect(harness.fatal).toEqual([]);
  });
});
