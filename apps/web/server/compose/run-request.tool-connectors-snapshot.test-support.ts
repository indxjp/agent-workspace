import { RunRequest } from '@agent-workspace/run-protocol';

import { expect, it } from 'vitest';

import { RUN, issued } from './run-request.fixture.test-support';
import type { createToolConnectorsFixture } from './run-request.tool-connectors.fixture.test-support';
export function registerSnapshotCases({
  ORDERS_LOW,
  ORDERS_HIGH,
  MCP_KEY,
  loaderWith,
  compose,
  orders,
}: ReturnType<typeof createToolConnectorsFixture>) {
  it('keys orders and Orders as orders and orders_2, both parseable as RunRequest server names', async () => {
    const request = await compose(
      loaderWith([
        { key: 'orders', name: 'orders', connectorId: ORDERS_LOW, operationNames: ['getOrder'] },
        {
          key: 'orders_2',
          name: 'orders_2',
          connectorId: ORDERS_HIGH,
          operationNames: ['getOrder'],
        },
      ]),
      () => Promise.resolve(),
    );
    expect(Object.keys(request.portable.mcpServers)).toEqual([MCP_KEY, 'orders', 'orders_2']);
    expect(RunRequest.safeParse(request).success).toBe(true);
  });
  it('records the tool snapshot once with the sorted ids after the token is issued, before it resolves', async () => {
    const calls: { runId: string; ids: readonly string[]; issuedAt: number }[] = [];
    const request = await compose(
      loaderWith([
        { key: 'orders', name: 'orders', connectorId: ORDERS_LOW, operationNames: ['getOrder'] },
        {
          key: 'orders_2',
          name: 'orders_2',
          connectorId: ORDERS_HIGH,
          operationNames: ['getOrder'],
        },
      ]),
      (runId, ids) => {
        calls.push({ runId, ids, issuedAt: issued });
        return Promise.resolve();
      },
    );
    expect(calls).toEqual([{ runId: RUN, ids: [ORDERS_LOW, ORDERS_HIGH], issuedAt: issued }]);
    expect(request.env['ANTHROPIC_AUTH_TOKEN']).toBe(`run-token-${String(issued)}`);
  });
  it('fails closed with tool entries and no sink, and calls no sink without tool entries', async () => {
    await expect(compose(loaderWith(orders), undefined)).rejects.toThrow(
      /no tool snapshot is configured/u,
    );
    const sink = (): Promise<void> => Promise.reject(new Error('must not be called'));
    await expect(compose(loaderWith(undefined), sink)).resolves.toBeDefined();
    await expect(compose(loaderWith([]), sink)).resolves.toBeDefined();
  });
  it('does not resolve when the snapshot fails', async () => {
    await expect(
      compose(loaderWith(orders), () => Promise.reject(new Error('snapshot down'))),
    ).rejects.toThrow('snapshot down');
  });
}
